import {withInstanceMediaRead} from '../_media-read';
import {ANIMATIC_NS,animaticCandidateMatchesJob} from '../../../../host/instance-runtime/animatic-service.mjs';
import {domainRepository} from '../../instance/_domain';
import {domainReferenceEligibility} from '../../../../host/instance-runtime/domain-reference.mjs';
import { readFile } from 'node:fs/promises';
import {
  appendEvent,
  assertStableFileIdentity,
  assertJsonObject,
  assertSha256,
  assertStableId,
  errorResponse,
  eventLimit,
  hashStableFile,
  HttpError,
  jsonResponse,
  listAllEvents,
  mediaToken,
  mutationRequestHash,
  optionalString,
  recipeCatalog,
  reviewData,
  replayIdempotentEvent,
  safeReviewPendingPath,
  stableObjectHash,
  validateMutationRequest,
} from '../_store';
import {
  assertCallPackageHash,
  assertExecutionRequestBinding,
  canonicalInputBindings,
  executionRequestId as parseExecutionRequestId,
  inputBindingsHash,
  latestAggregateEvent,
  projectedExecutionRequests,
} from '../_workflow';

function runState(event: Record<string, unknown>) {
  return String(event.runState || event.state || '');
}

export type ProductionEvidenceStatus = 'VERIFIED' | 'MISSING' | 'CONFLICT';

export type ProductionEvidenceField = {
  status: ProductionEvidenceStatus;
  value?: unknown;
  reason: string;
};

export type ProductionEvidenceProjection = {
  projectionVersion: '1.0';
  fields: {
    inputBindings: ProductionEvidenceField;
    actualPrompt: ProductionEvidenceField;
    executionDefinition: ProductionEvidenceField;
    model: ProductionEvidenceField;
    parameters: ProductionEvidenceField;
    run: ProductionEvidenceField;
    output: ProductionEvidenceField;
    parentVersion: ProductionEvidenceField;
  };
  counts: Record<ProductionEvidenceStatus, number>;
};

type EvidenceProjectionSources = {
  runEvents: Record<string, unknown>[];
  executionRequestEvents: Record<string, unknown>[];
  definitions: Record<string, unknown>[];
  versions: Record<string, unknown>[];
  candidateEvents: Record<string, unknown>[];
};

function evidenceField(status: ProductionEvidenceStatus, reason: string, value?: unknown): ProductionEvidenceField {
  return value === undefined ? { status, reason } : { status, reason, value };
}

function exactSha(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function latestEvidenceEvent(events: Record<string, unknown>[], field: string, id: string) {
  return events
    .filter((event) => String(event[field] || '') === id)
    .sort((left, right) => {
      const sequenceDelta = Number(right.eventSequence || 0) - Number(left.eventSequence || 0);
      if (sequenceDelta) return sequenceDelta;
      return String(right.recordedAt || '').localeCompare(String(left.recordedAt || ''));
    })[0] || null;
}

/**
 * Builds a fail-closed, field-level projection for displaying production facts.
 * Raw event values are deliberately not copied into a field unless the evidence
 * needed for that field has been recomputed and verified on the server.
 */
export function projectProductionEvidence(
  candidate: Record<string, unknown>,
  sources: EvidenceProjectionSources,
): ProductionEvidenceProjection {
  const recordedPromptHash = exactSha(candidate.actualPromptHash);
  const hasPrompt = Object.prototype.hasOwnProperty.call(candidate, 'actualPrompt')
    && candidate.actualPrompt != null
    && !(typeof candidate.actualPrompt === 'string' && !candidate.actualPrompt.trim());
  const actualPrompt = !hasPrompt
    ? evidenceField('MISSING', '未登记可回放的实际 Prompt。')
    : !recordedPromptHash
      ? evidenceField('MISSING', '实际 Prompt 未登记有效 SHA-256。')
      : stableObjectHash(candidate.actualPrompt) !== recordedPromptHash
        ? evidenceField('CONFLICT', '实际 Prompt 内容与登记哈希不一致。')
        : evidenceField('VERIFIED', '实际 Prompt 内容已由服务端重算哈希并核验。', {
          content: candidate.actualPrompt,
          sha256: recordedPromptHash,
        });

  const recordedBindingsHash = exactSha(candidate.inputBindingsHash);
  const inputBindings = !Array.isArray(candidate.inputBindings)
    ? evidenceField('MISSING', '未登记输入附件与版本绑定快照。')
    : !recordedBindingsHash
      ? evidenceField('MISSING', '输入绑定未登记有效 SHA-256。')
      : stableObjectHash(candidate.inputBindings) !== recordedBindingsHash
        ? evidenceField('CONFLICT', '输入绑定内容与登记哈希不一致。')
        : evidenceField('VERIFIED', '输入绑定内容已由服务端重算哈希并核验。', {
          bindings: candidate.inputBindings,
          sha256: recordedBindingsHash,
        });

  const executionDefinitionId = typeof candidate.executionDefinitionId === 'string'
    ? candidate.executionDefinitionId.trim()
    : '';
  const definitionHashAtExecution = exactSha(candidate.executionDefinitionHash);
  const callPackageHash = exactSha(candidate.callPackageHash);
  const definition = executionDefinitionId
    ? sources.definitions.find((item) => item.id === executionDefinitionId) || null
    : null;
  const declaredDefinitionHash = exactSha(definition?.definitionHash);
  const calculatedDefinitionHash = definition
    ? stableObjectHash(Object.fromEntries(Object.entries(definition).filter(([key]) => !['definitionHash', 'currentRevisionId'].includes(key))))
    : null;
  const recipePromptHash = definition ? stableObjectHash(definition.prompt ?? null) : null;
  let executionDefinition: ProductionEvidenceField;
  if (!executionDefinitionId || !definitionHashAtExecution || !callPackageHash) {
    executionDefinition = evidenceField('MISSING', '执行定义标识或调用包哈希缺项。');
  } else if (definitionHashAtExecution !== callPackageHash) {
    executionDefinition = evidenceField('CONFLICT', '候选登记的执行定义哈希与调用包哈希不一致。');
  } else if (!definition || !declaredDefinitionHash) {
    executionDefinition = evidenceField('MISSING', '无法解析与本次调用包对应的执行定义。');
  } else if (declaredDefinitionHash !== calculatedDefinitionHash) {
    executionDefinition = evidenceField('CONFLICT', '执行定义内容与其声明哈希不一致。');
  } else if (declaredDefinitionHash !== callPackageHash) {
    executionDefinition = evidenceField('CONFLICT', '当前可解析执行定义与历史调用包并非同一精确版本。');
  } else if (!exactSha(candidate.recipePromptHash)) {
    executionDefinition = evidenceField('MISSING', '候选未登记配方 Prompt 哈希，不能证明完整调用包。');
  } else if (exactSha(candidate.recipePromptHash) !== recipePromptHash) {
    executionDefinition = evidenceField('CONFLICT', '候选登记的配方 Prompt 哈希与执行定义不一致。');
  } else {
    executionDefinition = evidenceField('VERIFIED', '执行定义内容、定义哈希、调用包和配方 Prompt 已精确核验。', {
      executionDefinitionId,
      definitionHash: declaredDefinitionHash,
      callPackageHash,
      promptRevisionId: typeof candidate.promptRevisionId === 'string' ? candidate.promptRevisionId : null,
    });
  }

  const model = executionDefinition.status !== 'VERIFIED'
    ? evidenceField(executionDefinition.status, executionDefinition.reason)
    : definition?.model == null
      ? evidenceField('MISSING', '精确执行定义未登记模型或执行器。')
      : evidenceField('VERIFIED', '模型与执行器来自已核验的精确执行定义。', definition.model);
  const parameters = executionDefinition.status !== 'VERIFIED'
    ? evidenceField(executionDefinition.status, executionDefinition.reason)
    : evidenceField('VERIFIED', '参数来自已核验的精确执行定义。', definition?.parametersRaw ?? '无额外参数（调用包已明确）');

  const executionRequestId = typeof candidate.executionRequestId === 'string' ? candidate.executionRequestId.trim() : '';
  const runId = typeof candidate.runId === 'string' ? candidate.runId.trim() : '';
  const requestEvent = executionRequestId
    ? latestEvidenceEvent(sources.executionRequestEvents, 'executionRequestId', executionRequestId)
    : null;
  const runEvent = runId ? latestEvidenceEvent(sources.runEvents, 'runId', runId) : null;
  let run: ProductionEvidenceField;
  if (!executionRequestId || !runId) {
    run = evidenceField('MISSING', 'executionRequestId 或 runId 缺项。');
  } else if (!requestEvent || !runEvent) {
    run = evidenceField('MISSING', '找不到对应的 ExecutionRequestEvent 或 RunEvent。');
  } else if (
    executionDefinition.status !== 'VERIFIED'
    || inputBindings.status !== 'VERIFIED'
    || runState(runEvent) !== 'SUCCEEDED'
    || String(runEvent.executionRequestId || '') !== executionRequestId
    || String(runEvent.executionDefinitionId || '') !== executionDefinitionId
    || exactSha(runEvent.callPackageHash) !== callPackageHash
    || exactSha(runEvent.inputBindingsHash) !== recordedBindingsHash
    || String(requestEvent.executionDefinitionId || '') !== executionDefinitionId
    || exactSha(requestEvent.callPackageHash) !== callPackageHash
    || exactSha(requestEvent.inputBindingsHash) !== recordedBindingsHash
    || (requestEvent.familyId != null && String(requestEvent.familyId) !== String(candidate.familyId || ''))
  ) {
    run = evidenceField('CONFLICT', 'Run、执行请求、调用包、输入绑定或成功状态存在冲突。');
  } else {
    run = evidenceField('VERIFIED', 'Run 已成功，且与同一执行请求、调用包和输入绑定精确一致。', {
      runId,
      executionRequestId,
      executionDefinitionId,
      callPackageHash,
    });
  }

  const eventSha = exactSha(candidate.sha256);
  const eventPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
  const registeredVersion = sources.versions.find((item) => item.id === candidate.versionId && item.familyId === candidate.familyId) || null;
  const registeredSha = exactSha(registeredVersion?.sha256);
  const registeredPath = typeof registeredVersion?.path === 'string' ? registeredVersion.path.trim() : '';
  const output = !eventPath || !eventSha
    ? evidenceField('MISSING', '候选事件未登记产出路径或有效 SHA-256。')
    : registeredVersion && (registeredSha !== eventSha || registeredPath !== eventPath)
      ? evidenceField('CONFLICT', '候选事件与版本注册表的产出路径或 SHA-256 不一致。')
      : evidenceField('VERIFIED', '产出路径与 SHA-256 已绑定到该候选版本。', { path: eventPath, sha256: eventSha });

  const hasParentField = Object.prototype.hasOwnProperty.call(candidate, 'parentVersionId');
  const parentVersionId = typeof candidate.parentVersionId === 'string' && candidate.parentVersionId.trim()
    ? candidate.parentVersionId.trim()
    : null;
  const parentSha = exactSha(candidate.parentVersionSha256);
  const parentBindingState = typeof candidate.parentBindingState === 'string' ? candidate.parentBindingState : '';
  let parentVersion: ProductionEvidenceField;
  if (!hasParentField) {
    parentVersion = evidenceField('MISSING', '未登记父版本或显式根版本关系。');
  } else if (!parentVersionId) {
    parentVersion = parentBindingState === 'EXPLICIT_ROOT'
      ? evidenceField('VERIFIED', '已核验为显式根版本。', { parentVersionId: null, parentVersionSha256: null, parentBindingState })
      : evidenceField(parentBindingState ? 'CONFLICT' : 'MISSING', '空父版本未绑定 EXPLICIT_ROOT。');
  } else if (!parentSha) {
    parentVersion = evidenceField('MISSING', '父版本缺少有效 SHA-256。');
  } else {
    const parentResolved = [...sources.versions, ...sources.candidateEvents].some((item) => (
      item.familyId === candidate.familyId
      && item.id !== candidate.versionId
      && String(item.versionId || item.id || '') === parentVersionId
      && exactSha(item.sha256) === parentSha
    ));
    parentVersion = parentResolved
      ? evidenceField('VERIFIED', '父版本与 SHA-256 已解析到同资产族版本。', {
        parentVersionId,
        parentVersionSha256: parentSha,
        parentBindingState: parentBindingState || 'BOUND',
      })
      : evidenceField('CONFLICT', '父版本与 SHA-256 无法解析到同资产族版本。');
  }

  const fields = { inputBindings, actualPrompt, executionDefinition, model, parameters, run, output, parentVersion };
  const counts = Object.values(fields).reduce<Record<ProductionEvidenceStatus, number>>((result, field) => {
    result[field.status] += 1;
    return result;
  }, { VERIFIED: 0, MISSING: 0, CONFLICT: 0 });
  return { projectionVersion: '1.0', fields, counts };
}

const candidateExtensions = new Set([
  'png', 'jpg', 'jpeg', 'webp',
  'wav', 'mp3', 'm4a', 'flac',
  'mp4', 'mov', 'webm',
  'txt', 'md', 'srt', 'vtt',
]);
const textCandidateExtensions = new Set(['txt', 'md', 'srt', 'vtt']);

function actualPrompt(value: unknown) {
  if (typeof value === 'string') {
    const prompt = value.trim();
    if (!prompt || Buffer.byteLength(prompt, 'utf8') > 250_000) throw new HttpError(400, 'actualPrompt is invalid');
    return prompt;
  }
  return assertJsonObject(value, 'actualPrompt', 250_000);
}

function knownVersion(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  candidates: Awaited<ReturnType<typeof listAllEvents>>,
  versionId: string,
) {
  const candidate = candidates.find((event) => event.versionId === versionId);
  if (candidate) {
    return {
      id: versionId,
      familyId: String(candidate.familyId || ''),
      sha256: String(candidate.sha256 || ''),
      path: typeof candidate.path === 'string' ? candidate.path : null,
      outputState: String(candidate.outputState || 'PRESENT'),
      source: 'ASSET_VERSION_EVENT' as const,
    };
  }
  const source = data.productionModel.assetVersions.find((version) => version.id === versionId);
  return source ? {
    id: versionId,
    familyId: source.familyId,
    sha256: source.sha256 || '',
    path: source.path,
    outputState: source.outputState || (source.materializationState === 'GENERATED' ? 'PRESENT' : 'NOT_PRODUCED'),
    source: 'BASE_SNAPSHOT' as const,
  } : null;
}

function isMaterializedVersion(version: ReturnType<typeof knownVersion>) {
  return Boolean(version?.path && /^[a-f0-9]{64}$/i.test(version.sha256) && version.outputState === 'PRESENT');
}

function defaultVersionId(
  familyId: string,
  plannedVersionId: string,
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  candidates: Awaited<ReturnType<typeof listAllEvents>>,
) {
  if (plannedVersionId && !plannedVersionId.startsWith(`${familyId}@`)) {
    throw new HttpError(409, 'ExpectedOutput legacyVersionId is bound to another asset family');
  }
  if (plannedVersionId && !isMaterializedVersion(knownVersion(data, candidates, plannedVersionId))) {
    return { versionId: plannedVersionId, plannedVersionId };
  }
  const ids = [
    ...data.productionModel.assetVersions.filter((version) => version.familyId === familyId).map((version) => version.id),
    ...candidates.filter((event) => event.familyId === familyId).map((event) => String(event.versionId || '')),
  ];
  const numericVersions = ids.map((id) => id.match(/@V(\d+)$/i)).filter(Boolean).map((match) => Number(match![1]));
  if (numericVersions.length) {
    return {
      versionId: `${familyId}@V${String(Math.max(...numericVersions) + 1).padStart(3, '0')}`,
      plannedVersionId,
    };
  }
  return { versionId: `${familyId}@EVENT-${stableObjectHash(ids).slice(0, 24).toUpperCase()}`, plannedVersionId };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const familyId = url.searchParams.get('familyId');
    const versionId = url.searchParams.get('versionId');
    const sha256 = url.searchParams.get('sha256');
    const runId = url.searchParams.get('runId');
    const executionRequestId = url.searchParams.get('executionRequestId');
    const includeProductionEvidence = url.searchParams.get('productionEvidence') === '1';
    const limit = eventLimit(url.searchParams.get('limit'));
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new HttpError(400, 'sha256 is invalid');
    if (includeProductionEvidence && (!familyId || !versionId || !sha256)) {
      throw new HttpError(400, 'productionEvidence requires exact familyId, versionId, and sha256');
    }
    const allCandidates = await listAllEvents('asset-version');
    const events = allCandidates
      .filter((event) => !familyId || event.familyId === familyId)
      .filter((event) => !versionId || event.versionId === versionId)
      .filter((event) => !sha256 || String(event.sha256 || '').toLowerCase() === sha256.toLowerCase())
      .filter((event) => !runId || event.runId === runId)
      .filter((event) => !executionRequestId || event.executionRequestId === executionRequestId)
      .slice(0, limit);
    if (!includeProductionEvidence) return jsonResponse({ events, count: events.length });
    const [runEvents, executionRequestEvents, recipes, data] = await Promise.all([
      listAllEvents('run'),
      listAllEvents('execution-request'),
      recipeCatalog(),
      reviewData(),
    ]);
    const sources: EvidenceProjectionSources = {
      runEvents,
      executionRequestEvents,
      definitions: recipes.executionDefinitions,
      versions: data.productionModel.assetVersions,
      candidateEvents: allCandidates,
    };
    return jsonResponse({
      events: events.map((event) => ({
        ...event,
        productionEvidence: projectProductionEvidence(event, sources),
      })),
      count: events.length,
    });
  } catch (reason) {
    return errorResponse(reason, 'candidate version events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    if(body.executorKind==='DETERMINISTIC_RENDER'){
      // Deterministic results are registered atomically by the worker. The HTTP
      // endpoint can only replay a verified receipt, never author a render fact.
      const repo=await domainRepository();return withInstanceMediaRead(async()=>repo.readTransaction(async tx=>{
        const record=await tx.getAux(ANIMATIC_NS.jobs,String(body.renderJobId||''));
        const job=record&&!record.deleted?JSON.parse(Buffer.from(record.bytes).toString('utf8')):null;
        const event=(await listAllEvents('asset-version')).find(e=>e.eventId===job?.result?.registrationEventId);
        const media=job?.result?await tx.getMedia(job.result.familyId,job.result.versionId):null;
        const registrationVerified=Boolean(media&&media.sha256===job.result.sha256&&media.byteSize===job.result.byteSize&&media.relativePath===job.result.relativePath&&media.metadata?.registrationEventId===event?.eventId);
        if(!event||!animaticCandidateMatchesJob(event,[{...job,registrationVerified}])||body.versionId!==event.versionId||body.familyId!==event.familyId||body.sha256!==event.sha256)throw new HttpError(409,'没有与精确产物相符的已完成受控预演任务');
        const file=await hashStableFile(await safeReviewPendingPath(String(event.path)));
        if(file.sha256!==event.sha256||file.size!==event.byteSize)throw new HttpError(409,'预演候选实际文件与完成回执不符');
        return jsonResponse({event,eventId:event.eventId,replayed:true,versionId:event.versionId,sha256:event.sha256,mediaUrl:'/api/v8/media/'+event.mediaToken});
      }));
    }
    const rawRequestHash = mutationRequestHash('asset-version', body);
    const replay = await replayIdempotentEvent('asset-version', idempotencyKey, rawRequestHash);
    if (replay) {
      const replayToken = String(replay.event.mediaToken || '');
      return jsonResponse({
        eventId: replay.event.eventId,
        replayed: true,
        versionId: replay.event.versionId,
        sha256: replay.event.sha256,
        mediaToken: replayToken,
        mediaUrl: `/api/v8/media/${replayToken}`,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        operationalRevision: replay.operations.operationalRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
        appliedProjection: replay.operations.stateProjection,
      }, { headers: { ETag: replay.operations.etag } });
    }
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const familyId = assertStableId(body.familyId, 'familyId');
    const projectPath = optionalString(body.path, 2000);
    const executionRequestId = parseExecutionRequestId(body.executionRequestId);
    const runId = assertStableId(body.runId, 'runId', 200);
    const executionDefinitionId = assertStableId(body.executionDefinitionId, 'executionDefinitionId');
    const label = optionalString(body.label, 300);
    const note = optionalString(body.note, 20_000);
    if (!projectPath) throw new HttpError(400, 'path is required');
    if (!runId.startsWith('run_')) throw new HttpError(400, 'runId is invalid');
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    if (!data.productionModel.assetFamilies.some((item) => item.id === familyId)) throw new HttpError(422, 'unknown familyId');
    const candidateExtension = projectPath.split('.').pop()?.toLowerCase() || '';
    if (!candidateExtensions.has(candidateExtension)) {
      throw new HttpError(400, 'unsupported candidate media type');
    }
    if (textCandidateExtensions.has(candidateExtension)) {
      const linkedTextRequirement = (data.productionModel.materialRequirements || []).some((requirement) => (
        requirement.assetFamilyRefs.includes(familyId) && String(requirement.mediaType || '') === 'TEXT'
      ));
      if (!linkedTextRequirement) {
        throw new HttpError(422, 'text candidate requires a TEXT material requirement; Prompt files remain execution definitions');
      }
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'parentVersionId')) {
      throw new HttpError(400, 'parentVersionId must be explicitly supplied as a version id or null');
    }
    const requestedParentVersionId = body.parentVersionId == null || body.parentVersionId === ''
      ? null
      : assertStableId(body.parentVersionId, 'parentVersionId');

    const catalog = await recipeCatalog();
    const definition = catalog.executionDefinitions.find((item) => item.id === executionDefinitionId);
    if (!definition) throw new HttpError(422, 'unknown executionDefinitionId');
    const output = definition.output && typeof definition.output === 'object' && !Array.isArray(definition.output)
      ? definition.output as Record<string, unknown>
      : {};
    if (output.assetFamilyRef !== familyId) throw new HttpError(422, 'execution definition output is bound to another familyId');
    const expectedOutputId = assertStableId(body.expectedOutputId, 'expectedOutputId');
    if (output.expectedOutputRef !== expectedOutputId) {
      throw new HttpError(422, 'expectedOutputId does not match the execution definition output');
    }
    const expectedOutput = (data.productionModel.expectedOutputs || []).find((item) => item.id === expectedOutputId);
    if (!expectedOutput) throw new HttpError(422, 'expectedOutputId does not resolve in the current business graph');
    if (expectedOutput.familyId !== familyId) throw new HttpError(422, 'ExpectedOutput belongs to another asset family');
    if (expectedOutput.targetPath !== projectPath || output.path !== projectPath) {
      throw new HttpError(422, 'candidate path must exactly match the ExpectedOutput and execution definition targetPath');
    }
    const outputFamily = data.productionModel.assetFamilies.find((item) => item.id === familyId)!;
    if (!(outputFamily.expectedOutputRefs || []).includes(expectedOutputId)) {
      throw new HttpError(422, 'ExpectedOutput is not registered on the target asset family');
    }
    if (outputFamily.currentExpectedOutputId !== expectedOutputId) {
      throw new HttpError(409, 'ExpectedOutput is not the current planned output for this asset family');
    }
    const callPackageHash = assertCallPackageHash(body.callPackageHash, definition);
    if (body.executionDefinitionHash != null) {
      const suppliedDefinitionHash = assertSha256(body.executionDefinitionHash, 'executionDefinitionHash');
      if (suppliedDefinitionHash !== callPackageHash) throw new HttpError(409, 'executionDefinitionHash is stale');
    }
    const [requestEvents, existingCandidates, runEvents] = await Promise.all([
      listAllEvents('execution-request'),
      listAllEvents('asset-version'),
      listAllEvents('run'),
    ]);
    const currentRequest = projectedExecutionRequests(requestEvents, existingCandidates)
      .find((event) => event.executionRequestId === executionRequestId) || null;
    if (!currentRequest) throw new HttpError(422, 'unknown executionRequestId');
    assertExecutionRequestBinding(currentRequest, { executionRequestId, executionDefinitionId, callPackageHash, familyId });
    if (currentRequest.snapshotId !== snapshotId) throw new HttpError(409, 'execution request belongs to another base snapshot');
    if (!['AUTHORIZED', 'CLAIMED'].includes(String(currentRequest.requestState || currentRequest.status || ''))) {
      throw new HttpError(409, 'execution request is no longer active');
    }
    const currentRun = latestAggregateEvent(runEvents, 'runId', runId);
    if (!currentRun) throw new HttpError(422, 'unknown runId');
    if (currentRun.executionRequestId !== executionRequestId || currentRun.executionDefinitionId !== executionDefinitionId) {
      throw new HttpError(409, 'runId is bound to another execution request or definition');
    }
    if (currentRun.callPackageHash !== callPackageHash) throw new HttpError(409, 'runId is bound to another call package');
    if (runState(currentRun) !== 'SUCCEEDED') throw new HttpError(422, 'only a SUCCEEDED run can register a candidate version');

    const bindings = canonicalInputBindings(data, definition, body.inputBindings, existingCandidates);
    const bindingsHash = inputBindingsHash(bindings);
    if (bindingsHash !== currentRequest.inputBindingsHash || bindingsHash !== currentRun.inputBindingsHash) {
      throw new HttpError(409, 'actual inputBindings diverge from the authorized run');
    }
    const prompt = actualPrompt(body.actualPrompt);
    const actualPromptHash = stableObjectHash(prompt);
    if (body.actualPromptHash != null && body.actualPromptHash !== '') {
      const suppliedPromptHash = assertSha256(body.actualPromptHash, 'actualPromptHash');
      if (suppliedPromptHash !== actualPromptHash) throw new HttpError(409, 'actualPromptHash does not match actualPrompt');
    }
    const recipePromptHash = stableObjectHash(definition.prompt);
    const promptChangedFromCallPackage = recipePromptHash !== actualPromptHash;
    if (currentRequest.executor === 'CODEX' && promptChangedFromCallPackage) {
      throw new HttpError(422, 'CODEX result actualPrompt must exactly match the authorized call package');
    }

    const {filePath,file}=await withInstanceMediaRead(async()=>{
    const filePath = await safeReviewPendingPath(projectPath);
    const file = await hashStableFile(filePath);
    if (textCandidateExtensions.has(candidateExtension)) {
      if (file.size > 5 * 1024 * 1024) throw new HttpError(413, 'text candidate exceeds the 5 MiB review limit');
      const bytes = await readFile(filePath);
      let text = '';
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, 'text candidate must be valid UTF-8');
      }
      if (text.includes('\u0000')) throw new HttpError(400, 'text candidate contains NUL bytes');
    }
    return{filePath,file};
    });
    const suppliedVersionId = body.versionId == null || body.versionId === '' ? '' : assertStableId(body.versionId, 'versionId');
    const alreadyRealized = existingCandidates.find((candidate) => (
      candidate.expectedOutputId === expectedOutputId
      || (expectedOutput.legacyVersionId && candidate.plannedVersionId === expectedOutput.legacyVersionId)
    ));
    if (alreadyRealized) {
      throw new HttpError(409, 'ExpectedOutput already has a registered realizing AssetVersion', {
        expectedOutputId,
        realizedVersionId: alreadyRealized.versionId || null,
      });
    }
    const defaultVersion = defaultVersionId(
      familyId,
      typeof expectedOutput.legacyVersionId === 'string' ? expectedOutput.legacyVersionId : '',
      data,
      existingCandidates,
    );
    const versionId = suppliedVersionId || defaultVersion.versionId;
    if (suppliedVersionId && !suppliedVersionId.startsWith(`${familyId}@`)) {
      throw new HttpError(422, 'versionId must belong to familyId');
    }
    const existingVersion = knownVersion(data, existingCandidates, versionId);
    if (
      existingVersion
      && isMaterializedVersion(existingVersion)
      && (existingVersion.familyId !== familyId || existingVersion.sha256.toLowerCase() !== file.sha256)
    ) {
      throw new HttpError(409, 'versionId already identifies different media bytes');
    }
    let parentVersionId = requestedParentVersionId;
    let parentVersionSha256: string | null = null;
    let parentBindingState = parentVersionId ? 'BOUND' : 'EXPLICIT_ROOT';
    if (parentVersionId) {
      const parent = knownVersion(data, existingCandidates, parentVersionId);
      if (!parent || parent.familyId !== familyId) throw new HttpError(422, 'parentVersionId is not a version of familyId');
      if (!isMaterializedVersion(parent)) {
        const hasMaterializedFamilyVersion = [
          ...data.productionModel.assetVersions.filter((version) => version.familyId === familyId).map((version) => knownVersion(data, existingCandidates, version.id)),
          ...existingCandidates.filter((event) => event.familyId === familyId).map((event) => knownVersion(data, existingCandidates, String(event.versionId || ''))),
        ].some((version) => isMaterializedVersion(version));
        if (hasMaterializedFamilyVersion) {
          throw new HttpError(422, 'parentVersionId is only a planned placeholder while the family already has materialized history');
        }
        parentVersionId = null;
        parentBindingState = 'PLANNED_PLACEHOLDER_NORMALIZED_TO_ROOT';
      } else {
        if (parentVersionId === versionId) throw new HttpError(422, 'parentVersionId cannot equal the new versionId');
        parentVersionSha256 = parent.sha256.toLowerCase();
      }
    }
    const existingMaterializedFamilyVersions = [
      ...data.productionModel.assetVersions.filter((version) => version.familyId === familyId),
      ...existingCandidates.filter((event) => event.familyId === familyId),
    ].filter((version) => {
      const id = String('id' in version ? version.id : version.versionId || '');
      return isMaterializedVersion(knownVersion(data, existingCandidates, id));
    });
    if (existingMaterializedFamilyVersions.length && !parentVersionId && parentBindingState !== 'BOUND') {
      throw new HttpError(422, 'a new family version must bind an existing materialized parentVersionId');
    }
    const token = mediaToken(versionId);
    const semanticRequest = {
      snapshotId,
      familyId,
      versionId,
      label: label || versionId,
      path: projectPath,
      sha256: file.sha256,
      byteSize: file.size,
      mediaToken: token,
      expectedOutputId,
      realizationRelation: 'REALIZES',
      realizes: {
        relationType: 'REALIZES',
        expectedOutputId,
        assetVersionId: versionId,
      },
      plannedVersionId: defaultVersion.plannedVersionId || null,
      requestedParentVersionId,
      parentVersionId,
      parentVersionSha256,
      parentBindingState,
      executionRequestId,
      runId,
      executionDefinitionId,
      executionDefinitionHash: callPackageHash,
      promptRevisionId: currentRequest.promptRevisionId || '',
      callPackageHash,
      actualPrompt: prompt,
      actualPromptHash,
      recipePromptHash,
      promptChangedFromCallPackage,
      promptSyncRequired: promptChangedFromCallPackage,
      inputBindings: bindings,
      inputBindingsHash: bindingsHash,
      domainReferenceHash: currentRequest.domainReferenceHash||null,
      note,
    };
    const { event, replayed, operations } = await appendEvent(
      'asset-version',
      idempotencyKey,
      mutationRequestHash('asset-version', semanticRequest),
      ifMatch,
      {
        ...semanticRequest,
        rawRequestHash,
        outputState: 'PRESENT',
        reviewDecision: 'PENDING',
        projectRightsGate: 'UNKNOWN',
        historyRole: 'CANDIDATE',
        lifecycleState: 'REVIEW_PENDING',
        canFlowDownstream: false,
        flowBlockReasons: ['REVIEW_PENDING', 'RIGHTS_CONFIRMATION_REQUIRED_IN_REVIEW'],
        rightsWarning: true,
        preflight: { status: 'UNKNOWN', role: 'REVIEW_EVIDENCE_ONLY', sourceRef: null },
        registrationState: 'CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED',
        expectationState: 'REALIZED',
        adoptionPerformed: false,
      },
      '1.1',
      async (locked) => {
        await assertStableFileIdentity(filePath, file);
        const currentCatalog = await recipeCatalog();
        const lockedDefinition = currentCatalog.executionDefinitions.find((item) => item.id === executionDefinitionId);
        if (!lockedDefinition || lockedDefinition.definitionHash !== callPackageHash) {
          throw new HttpError(409, 'candidate call package changed while registration was in flight');
        }
        const lockedRequest = projectedExecutionRequests(locked.executionRequests.events, locked.candidates.events)
          .find((item) => item.executionRequestId === executionRequestId) || null;
        if (!lockedRequest || !['AUTHORIZED', 'CLAIMED'].includes(String(lockedRequest.requestState || lockedRequest.status || ''))) {
          throw new HttpError(409, 'execution request is no longer active');
        }
        assertExecutionRequestBinding(lockedRequest, { executionRequestId, executionDefinitionId, callPackageHash, familyId });
        const referenceReasons=domainReferenceEligibility(locked.stateProjection,familyId,bindings);
        if(referenceReasons.length)throw new HttpError(422,'实际参考未通过当前关系规则',{eligibilityReasons:referenceReasons});
        const lockedFamily = locked.stateProjection.assetFamiliesById[familyId];
        if(lockedRequest.domainReferenceHash&&lockedFamily?.domainContextHash!==lockedRequest.domainReferenceHash)throw new HttpError(409,'素材关系已变化，请重新冻结制作输入');
        if (!lockedFamily || lockedFamily.currentExpectedOutputId !== expectedOutputId) {
          throw new HttpError(409, 'ExpectedOutput was realized or replaced while registration was in flight');
        }
        const lockedRun = latestAggregateEvent(locked.runs.events, 'runId', runId);
        if (!lockedRun || runState(lockedRun) !== 'SUCCEEDED') throw new HttpError(409, 'run is no longer SUCCEEDED');
        const registered = locked.candidates.events.filter((candidate) => candidate.executionRequestId === executionRequestId);
        if (registered.length >= Number(lockedRequest.maxOutputs || 1)) {
          throw new HttpError(409, 'execution request has already reached maxOutputs', { maxOutputs: lockedRequest.maxOutputs || 1 });
        }
      },
    );
    const eventVersionId = String(event.versionId || '');
    const eventSha256 = String(event.sha256 || '');
    const eventToken = String(event.mediaToken || '');
    return jsonResponse({
      eventId: event.eventId,
      replayed,
      versionId: eventVersionId,
      sha256: eventSha256,
      mediaToken: eventToken,
      mediaUrl: `/api/v8/media/${eventToken}`,
      event,
      operationRevision: operations.operationRevision,
      operationalRevision: operations.operationalRevision,
      etag: operations.etag,
      mutationEtag: operations.mutationEtag,
      appliedProjection: operations.stateProjection,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'invalid candidate version registration');
  }
}
