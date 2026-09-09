import { executionRuntimeReason, restoredUnresolvedRunsForWorkItem } from '../../../../host/instance-runtime/execution-epoch.mjs';
import {UNSTARTED_CANCELLATION_SCHEMA,cancellationHeadProof,readUnstartedCancellationBasis,buildUnstartedCancellation} from '../../../../host/instance-runtime/execution-cancellation.mjs';
import {canonicalJson} from '../../../../host/instance-runtime/bytes.mjs';
import { createHash } from 'node:crypto';
import {
  appendEvent,
  currentExecutionRuntime,
  assertStableId,
  errorResponse,
  eventLimit,
  HttpError,
  instanceRepository,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  optionalString,
  recipeCatalog,
  replayIdempotentEvent,
  validateMutationRequest,
} from '../_store';
import {
  assertCallPackageHash,
  assertExecutionEligibility,
  canonicalInputBindings,
  definitionForWorkItem,
  executionRequestExecutors,
  executionRequestId as parseExecutionRequestId,
  executionRequestStatuses,
  inputBindingsHash,
  projectedExecutionRequests,
  unresolvedResultUnknownRunsForWorkItem,
} from '../_workflow';

const actions = new Set(['AUTHORIZE', 'CLAIM', 'CANCEL']);

function requestStatus(event: Record<string, unknown>) {
  return String(event.requestState || event.status || '');
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'));
    const executor = url.searchParams.get('executor');
    const status = url.searchParams.get('status');
    const workItemId = url.searchParams.get('workItemId');
    const executionRequestId = url.searchParams.get('executionRequestId');
    if (executor && !executionRequestExecutors.has(executor)) throw new HttpError(400, 'executor is invalid');
    if (status && !executionRequestStatuses.has(status)) throw new HttpError(400, 'status is invalid');
    if (workItemId) assertStableId(workItemId, 'workItemId');
    if (executionRequestId) parseExecutionRequestId(executionRequestId);
    const [allEvents, candidates] = await Promise.all([
      listAllEvents('execution-request'),
      listAllEvents('asset-version'),
    ]);
    const latest = projectedExecutionRequests(allEvents, candidates)
      .filter((event) => !executor || event.executor === executor)
      .filter((event) => !status || requestStatus(event) === status)
      .filter((event) => !workItemId || event.workItemId === workItemId)
      .filter((event) => !executionRequestId || event.executionRequestId === executionRequestId)
      .slice(0, limit);
    const ids = new Set(latest.map((event) => event.executionRequestId));
    const events = allEvents.filter((event) => ids.has(event.executionRequestId)).slice(0, limit);
    let cancellation;
    if(url.searchParams.has('cancellation')){
      if(url.searchParams.get('cancellation')!=='1'||!executionRequestId)throw new HttpError(400,'cancellation inspection requires one exact executionRequestId');
      const repository=await instanceRepository();if(!repository)throw new HttpError(503,'cancellation inspection requires an explicit instance');
      const basis=await repository.readTransaction(tx=>readUnstartedCancellationBasis(tx,{executionRequestId}));
      cancellation={schemaVersion:UNSTARTED_CANCELLATION_SCHEMA,purpose:'CANCEL_UNSTARTED_ALLOCATION',requestSnapshotId:basis.head.snapshotId,expectedHead:cancellationHeadProof(basis.head),historyHash:basis.historyHash,notCalledEvidence:basis.notCalledEvidence,currentPublication:basis.publication,eligible:basis.notCalledEvidence.length>0,blockers:basis.notCalledEvidence.length?[]:['未提供精确旧请求的已记录 NOT_CALLED 核验依据；零 Run 不等于提供商未调用证明。']};
    }
    return jsonResponse({ requests: latest, events, count: latest.length, totalEvents: events.length,...(cancellation?{cancellation}:{}) });
  } catch (reason) {
    if((reason as {code?:string})?.code==='EXECUTION_CANCELLATION_CONFLICT')return errorResponse(new HttpError(409,(reason as Error).message),'execution cancellation unavailable');
    return errorResponse(reason, 'execution request events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('execution-request', body);
    const replay = await replayIdempotentEvent('execution-request', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        executionRequestId: replay.event.executionRequestId,
        status: replay.event.requestState,
        replayed: true,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        operationalRevision: replay.operations.operationalRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
      }, { headers: { ETag: replay.operations.etag } });
    }
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const action = body.action == null || body.action === '' ? 'AUTHORIZE' : assertStableId(body.action, 'action', 24);
    if (!actions.has(action)) throw new HttpError(400, 'action must be AUTHORIZE, CLAIM or CANCEL');
    if(Object.hasOwn(body,'cancellation')&&action!=='CANCEL')throw new HttpError(422,'cancellation receipt is only available for CANCEL');

    if(action==='CANCEL'&&Object.hasOwn(body,'cancellation')){
      if(snapshotId!==data.snapshotId)throw new HttpError(412,'body snapshotId does not match the current base snapshot');
      const executionRequestId=parseExecutionRequestId(body.executionRequestId),note=optionalString(body.note,20_000),repository=await instanceRepository();
      if(!repository)throw new HttpError(503,'versioned cancellation requires an explicit instance');
      const prepare=()=>repository.readTransaction(async tx=>buildUnstartedCancellation(await readUnstartedCancellationBasis(tx,{executionRequestId}),body.cancellation,{snapshotId,expectedEtag:ifMatch,note}));
      const payload=await prepare();
      const {event,replayed,operations}=await appendEvent('execution-request',idempotencyKey,mutationRequestHash('execution-request',payload),ifMatch,{...payload,rawRequestHash},'1.1',async()=>{
        if(canonicalJson(await prepare())!==canonicalJson(payload))throw new HttpError(409,'unstarted cancellation closure changed before append');
      });
      return jsonResponse({eventId:event.eventId,executionRequestId:event.executionRequestId,status:event.requestState,replayed,event,operationRevision:operations.operationRevision,operationalRevision:operations.operationalRevision,etag:operations.etag,mutationEtag:operations.mutationEtag},{status:replayed?200:201,headers:{ETag:operations.etag}});
    }

    if (action === 'AUTHORIZE') {
      if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
      const workItemId = assertStableId(body.workItemId, 'workItemId');
      const familyId = assertStableId(body.familyId, 'familyId');
      const executor = assertStableId(body.executor, 'executor', 32);
      if (!executionRequestExecutors.has(executor)) throw new HttpError(400, 'executor must be CODEX or USER_EXTERNAL');
      if (body.authorized !== true) throw new HttpError(422, 'authorization must explicitly set authorized=true');
      if (body.maxOutputs !== 1) throw new HttpError(422, 'maxOutputs must be exactly 1');
      const catalog = await recipeCatalog();
      const { workItem, definition } = definitionForWorkItem(data, catalog, workItemId);
      if (!workItem.outputAssetRef || workItem.outputAssetRef !== familyId) {
        throw new HttpError(422, 'familyId must be the work item output asset family');
      }
      if (body.executionDefinitionId != null && body.executionDefinitionId !== definition.id) {
        throw new HttpError(409, 'executionDefinitionId does not match the current work item definition');
      }
      const callPackageHash = assertCallPackageHash(body.callPackageHash, definition);
      const candidates = await listAllEvents('asset-version');
      const inputBindings = canonicalInputBindings(data, definition, body.inputBindings, candidates);
      const bindingsHash = inputBindingsHash(inputBindings);
      const executionRequestId = `xreq_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
      const authorizationRuntime = await currentExecutionRuntime();
      const semanticRequest = {
        ...(authorizationRuntime ? { authorizationRuntime } : {}),
        snapshotId,
        action,
        executionRequestId,
        workItemId,
        familyId,
        executionDefinitionId: definition.id,
        executionDefinitionHash: callPackageHash,
        promptRevisionId: typeof definition.currentRevisionId === 'string' ? definition.currentRevisionId : '',
        callPackageHash,
        executor,
        authorized: true,
        maxOutputs: 1,
        inputBindings,
        inputBindingsHash: bindingsHash,
        domainReferenceHash: ((data.productionModel.assetFamilies.find(f=>f.id===familyId) as unknown as {domainContext?:{hash?:string}})?.domainContext?.hash)||null,
      };
      const { event, replayed, operations } = await appendEvent(
        'execution-request',
        idempotencyKey,
        mutationRequestHash('execution-request', semanticRequest),
        ifMatch,
        {
          ...semanticRequest,
          rawRequestHash,
          requestState: 'AUTHORIZED',
          status: 'AUTHORIZED',
          authorizationScope: {
            snapshotId,
            workItemId,
            familyId,
            maxOutputs: 1,
          },
        },
        '1.0',
        async (locked) => {
          const currentCatalog = await recipeCatalog();
          const lockedDefinition = currentCatalog.executionDefinitions.find((item) => item.id === definition.id);
          if (!lockedDefinition || lockedDefinition.definitionHash !== callPackageHash) {
            throw new HttpError(409, 'call package changed while authorization was in flight');
          }
          const unresolvedRuns = unresolvedResultUnknownRunsForWorkItem(
            locked.executionRequests.events,
            locked.runs.events,
            workItemId,
          ).concat(restoredUnresolvedRunsForWorkItem(locked.executionRuntime, locked.executionRequests.events, locked.runs.events, workItemId));
          if (unresolvedRuns.length) {
            throw new HttpError(409, 'work item has an unresolved RESULT_UNKNOWN or restored pending run; reconcile provider evidence before authorizing another execution', {
              blockingRuns: unresolvedRuns.map((item) => ({
                runId: item.runId,
                executionRequestId: item.executionRequestId,
                snapshotId: item.snapshotId,
                executionDefinitionId: item.executionDefinitionId,
              })),
            });
          }
          assertExecutionEligibility(locked, lockedDefinition, semanticRequest);
          const active = projectedExecutionRequests(locked.executionRequests.events, locked.candidates.events)
            .find((item) => (
              item.snapshotId === data.snapshotId
              && item.workItemId === workItemId
              && ['AUTHORIZED', 'CLAIMED'].includes(requestStatus(item))
            ));
          if (active) throw new HttpError(409, 'work item already has an active execution request', { executionRequestId: active.executionRequestId });
        },
      );
      return jsonResponse({
        eventId: event.eventId,
        executionRequestId: event.executionRequestId,
        status: event.requestState,
        replayed,
        event,
        operationRevision: operations.operationRevision,
        operationalRevision: operations.operationalRevision,
        etag: operations.etag,
        mutationEtag: operations.mutationEtag,
      }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
    }

    const executionRequestId = parseExecutionRequestId(body.executionRequestId);
    const [existingEvents, candidates, catalog] = await Promise.all([
      listAllEvents('execution-request'),
      listAllEvents('asset-version'),
      recipeCatalog(),
    ]);
    const current = projectedExecutionRequests(existingEvents, candidates)
      .find((event) => event.executionRequestId === executionRequestId) || null;
    if (!current) throw new HttpError(422, 'unknown executionRequestId');
    const runtimeBlocked = executionRuntimeReason(await currentExecutionRuntime(), current);
    if (snapshotId !== data.snapshotId && !(action === 'CANCEL' && runtimeBlocked)) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    if (current.snapshotId !== snapshotId) throw new HttpError(409, 'execution request belongs to another base snapshot');
    const claimedBy = optionalString(body.claimedBy, 300);
    const note = optionalString(body.note, 20_000);
    const nextState = action === 'CLAIM' ? 'CLAIMED' : 'CANCELLED';
    if (action === 'CLAIM' && current.executor !== 'CODEX') throw new HttpError(422, 'only a CODEX execution request can be claimed');
    if (action === 'CANCEL' && !note) throw new HttpError(400, 'CANCEL requires a concrete note');
    const definition = catalog.executionDefinitions.find((item) => item.id === current.executionDefinitionId);
    if (!definition && action === 'CLAIM') throw new HttpError(422, 'execution request definition is unavailable');
    if (action === 'CLAIM' && definition?.definitionHash !== current.callPackageHash) {
      throw new HttpError(409, 'execution request call package is stale');
    }
    const semanticRequest = {
      ...(current.authorizationRuntime ? { authorizationRuntime: current.authorizationRuntime } : {}),
      snapshotId,
      action,
      executionRequestId,
      workItemId: current.workItemId,
      familyId: current.familyId,
      executionDefinitionId: current.executionDefinitionId,
      executionDefinitionHash: current.executionDefinitionHash,
      promptRevisionId: current.promptRevisionId,
      callPackageHash: current.callPackageHash,
      executor: current.executor,
      authorized: current.authorized,
      maxOutputs: current.maxOutputs,
      inputBindings: current.inputBindings,
      inputBindingsHash: current.inputBindingsHash,
      claimedBy,
      note,
    };
    const { event, replayed, operations } = await appendEvent(
      'execution-request',
      idempotencyKey,
      mutationRequestHash('execution-request', semanticRequest),
      ifMatch,
      { ...semanticRequest, rawRequestHash, requestState: nextState, status: nextState },
      '1.0',
      async (locked) => {
        const latest = projectedExecutionRequests(locked.executionRequests.events, locked.candidates.events)
          .find((item) => item.executionRequestId === executionRequestId) || null;
        if (!latest) throw new HttpError(422, 'unknown executionRequestId');
        const latestStatus = requestStatus(latest);
        if (action === 'CLAIM' && latestStatus !== 'AUTHORIZED') {
          throw new HttpError(409, `execution request cannot transition from ${latestStatus} to CLAIMED`);
        }
        if (action === 'CLAIM') {
          const currentCatalog = await recipeCatalog();
          const lockedDefinition = currentCatalog.executionDefinitions.find((item) => item.id === current.executionDefinitionId);
          if (!lockedDefinition || lockedDefinition.definitionHash !== latest.callPackageHash) {
            throw new HttpError(409, 'execution request call package changed while claim was in flight');
          }
          assertExecutionEligibility(locked, lockedDefinition, latest);
        }
        if (action === 'CANCEL' && !['AUTHORIZED', 'CLAIMED'].includes(latestStatus)) {
          throw new HttpError(409, `execution request cannot transition from ${latestStatus} to CANCELLED`);
        }
        if (action === 'CANCEL') {
          const activeRun = locked.runs.latestByRunId
            .map(({ event }) => event)
            .filter((item) => item.executionRequestId === executionRequestId)
            .find((item) => ['PLANNED', 'SUBMITTED', 'RUNNING', 'RESULT_UNKNOWN'].includes(String(item.runState || item.state || '')));
          if (activeRun) {
            throw new HttpError(409, 'an active or unresolved run must reach a terminal state before cancelling its execution request', {
              runId: activeRun.runId,
              runState: activeRun.runState || activeRun.state,
            });
          }
        }
      },
    );
    return jsonResponse({
      eventId: event.eventId,
      executionRequestId: event.executionRequestId,
      status: event.requestState,
      replayed,
      event,
      operationRevision: operations.operationRevision,
      operationalRevision: operations.operationalRevision,
      etag: operations.etag,
      mutationEtag: operations.mutationEtag,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    if((reason as {code?:string})?.code==='EXECUTION_CANCELLATION_CONFLICT')return errorResponse(new HttpError(409,(reason as Error).message),'execution cancellation unavailable');
    return errorResponse(reason, 'invalid execution request event');
  }
}
