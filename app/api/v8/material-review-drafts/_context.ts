import {withInstanceMediaRead} from '../_media-read';
import {inspectExecutionDefinitionHash} from '../../../../host/instance-runtime/execution-definition-hash.mjs';
import {resolveFormalReviewSpec} from '../_review-spec';
import {
  assetReviewContextHash,
  hasMaterialRequirementCompatibility,
  hashStableFile,
  HttpError,
  listAllEvents,
  recipeCatalog,
  safeGeneratedPath,
  stableObjectHash,
  type EventRecord,
  type ReviewData,
} from '../_store';

type Row = Record<string, unknown> & { id: string };

export type MaterialReviewAuthorityContext = {
  schemaVersion: '1.0';
  reviewSpec?: import('../../../../host/instance-runtime/configuration-model.mjs').ReviewSpec | null;
  configurationBinding?: unknown;
  snapshotId: string;
  target: {
    requirementId: string;
    familyId: string;
    versionId: string;
    versionSha256: string;
    contextHash: string;
  };
  requirement: {
    title: string;
    requirementHash: string;
    reuseScope: string;
    storyBasis: unknown;
    episodeIds: string[];
    sceneIds: string[];
    currentShotIds: string[];
    acceptanceCriteria: Array<{ criterionId: string; label: string }>;
  };
  artifact: {
    label: string;
    mediaKind: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'TEXT' | 'UNKNOWN';
    projectPath: string;
    byteSize: number;
    sha256: string;
    model: string | null;
    promptRef: string | null;
    lifecycleState: string;
    reviewDecision: string;
    projectRightsGate: string;
  };
  productionMaterials: {
    evidenceState: 'EXACT_CANDIDATE' | 'VERSION_REGISTRY_ONLY';
    missingFields: string[];
    candidateSnapshotId: string | null;
    definitionEvidenceState: 'CURRENT_DEFINITION_EXACT_MATCH' | 'IMMUTABLE_HASH_ONLY' | 'NOT_AVAILABLE';
    executionDefinitionId: string | null;
    definitionHash: string | null;
    executionRequestId: string | null;
    runId: string | null;
    callPackageHash: string | null;
    promptRevisionId: string | null;
    actualPrompt: unknown;
    actualPromptHash: string | null;
    recipePrompt: unknown;
    recipePromptHash: string | null;
    promptChangedFromCallPackage: boolean | null;
    promptSyncRequired: boolean | null;
    upload: unknown;
    model: unknown;
    parameters: unknown;
    output: unknown;
    source: unknown;
    inputVersionBindings: unknown[];
    inputBindingsHash: string | null;
    parentVersionId: string | null;
    parentVersionSha256: string | null;
    parentBindingState: string;
    previousRevisionReview: {
      eventId: string;
      recordedAt: string;
      criterionFindings: unknown;
      revisionInstructions: unknown;
      note: string | null;
    } | null;
  };
  evidenceRefs: string[];
  observationMode: 'IMAGE_DIRECT' | 'METADATA_ONLY';
  inputBindingHash: string;
  resolvedMediaPath: string;
};

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === 'object' && typeof (item as Row).id === 'string')) : [];
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function exactSha(value: unknown) {
  const candidate = String(value || '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : '';
}

function eventState(event: EventRecord) {
  return String(event.runState || event.state || '');
}

function mediaKind(projectPath: string): MaterialReviewAuthorityContext['artifact']['mediaKind'] {
  const extension = projectPath.split('.').pop()?.toLowerCase();
  if (extension && ['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return 'IMAGE';
  if (extension && ['wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg'].includes(extension)) return 'AUDIO';
  if (extension && ['mp4', 'mov', 'webm', 'mkv'].includes(extension)) return 'VIDEO';
  if (extension && ['md', 'txt', 'srt', 'vtt'].includes(extension)) return 'TEXT';
  return 'UNKNOWN';
}

export async function buildMaterialReviewAuthorityContext({
  data,
  stateProjection,
  requirementId,
  familyId,
  versionId,
  versionSha256,
  contextHash,
}: {
  data: ReviewData;
  stateProjection: Record<string, unknown>;
  requirementId: string;
  familyId: string;
  versionId: string;
  versionSha256: string;
  contextHash: string;
}): Promise<MaterialReviewAuthorityContext> {
  const production = data.productionModel as unknown as Record<string, unknown>;
  const requirement = asRows(production.materialRequirements).find((item) => item.id === requirementId);
  if (!requirement || requirement.requirementClass !== 'REQUIRED') {
    throw new HttpError(404, 'current reusable material requirement was not found');
  }
  if (!strings(requirement.assetFamilyRefs).includes(familyId)) {
    throw new HttpError(409, 'family is not bound to the requested material requirement');
  }
  const family = asRows(production.assetFamilies).find((item) => item.id === familyId);
  if (!family) throw new HttpError(404, 'material family was not found');

  const projection = stateProjection as {
    assetFamiliesById?: Record<string, Row | undefined>;
    assetVersionsById?: Record<string, Row | undefined>;
  };
  const projectedFamily = projection.assetFamiliesById?.[familyId] || {} as Row;
  const allowedVersionIds = new Set([...strings(family.versionRefs), ...strings(projectedFamily.versionRefs)]);
  if (!allowedVersionIds.has(versionId)) throw new HttpError(409, 'version is not bound to the requested material family');
  const baseVersion = asRows(production.assetVersions).find((item) => item.id === versionId) || null;
  const projectedVersion = projection.assetVersionsById?.[versionId] || null;
  if (!baseVersion && !projectedVersion) throw new HttpError(404, 'material version was not found');
  const version = { ...(baseVersion || {}), ...(projectedVersion || {}), id: versionId } as Row;
  if (String(version.familyId || '') !== familyId) throw new HttpError(409, 'version family binding is stale');
  if (String(version.sha256 || '').toLowerCase() !== versionSha256.toLowerCase()) throw new HttpError(409, 'version SHA-256 changed; reload the material');
  const expectedContextHash = assetReviewContextHash(data, familyId, versionId, versionSha256);
  if (contextHash !== expectedContextHash) throw new HttpError(409, 'material review context changed; reload the current version');
  if (version.outputState === 'DELETED' || version.lifecycleState === 'DELETED_AUDIT') throw new HttpError(409, 'AI product review requires an existing artifact');
  const projectPath = String(version.path || '');
  if (!projectPath) throw new HttpError(409, 'review target has no registered media path');
  const {resolvedMediaPath,file}=await withInstanceMediaRead(async()=>{const resolvedMediaPath=await safeGeneratedPath(projectPath,{versionId,sha256:versionSha256});return{resolvedMediaPath,file:await hashStableFile(resolvedMediaPath)};});
  if (file.sha256 !== versionSha256.toLowerCase()) throw new HttpError(409, 'registered version SHA-256 does not match the current file bytes');

  const resolvedSpec=resolveFormalReviewSpec(data,'ASSET',familyId);
  const acceptanceCriteria=(resolvedSpec?.criteria||[]).map(c=>({criterionId:c.id,label:c.question||c.label}));
  if (!acceptanceCriteria.length) throw new HttpError(409, 'material acceptance criteria are missing');
  const kind = mediaKind(projectPath);
  const finishContext = (
    productionMaterials: MaterialReviewAuthorityContext['productionMaterials'],
    productionEvidenceRefs: string[],
  ): MaterialReviewAuthorityContext => {
    const evidenceRefs = [...new Set([
      `requirement:${requirementId}`,
      `family:${familyId}`,
      `version:${versionId}`,
      `file-sha256:${file.sha256}`,
      ...productionEvidenceRefs,
      ...strings(requirement.sceneIds).map((id) => `scene:${id}`),
    ])];
    const contextWithoutHash = {
      schemaVersion: '1.0' as const,
      reviewSpec:resolvedSpec, configurationBinding:requirement.configurationBinding,
      snapshotId: data.snapshotId,
      target: { requirementId, familyId, versionId, versionSha256: file.sha256, contextHash },
      requirement: {
        title: String(requirement.title || requirementId),
        requirementHash: String(requirement.requirementHash || ''),
        reuseScope: String(requirement.reuseScope || 'UNKNOWN'),
        storyBasis: requirement.storyBasis || null,
        episodeIds: strings(requirement.episodeIds),
        sceneIds: strings(requirement.sceneIds),
        currentShotIds: strings(requirement.currentShotIds),
        acceptanceCriteria,
      },
      artifact: {
        label: String(version.label || versionId),
        mediaKind: kind,
        projectPath,
        byteSize: file.size,
        sha256: file.sha256,
        model: typeof version.model === 'string' ? version.model : null,
        promptRef: typeof version.promptRef === 'string' ? version.promptRef : null,
        lifecycleState: String(version.lifecycleState || 'UNKNOWN'),
        reviewDecision: String(version.reviewDecision || 'UNKNOWN'),
        projectRightsGate: String(version.projectRightsGate || 'UNKNOWN'),
      },
      productionMaterials,
      evidenceRefs,
      observationMode: kind === 'IMAGE' ? 'IMAGE_DIRECT' as const : 'METADATA_ONLY' as const,
    };
    return {
      ...contextWithoutHash,
      inputBindingHash: stableObjectHash(contextWithoutHash),
      resolvedMediaPath,
    };
  };

  const assetVersionEvents = await listAllEvents('asset-version');
  const candidateMatches = assetVersionEvents.filter((event) => (
    event.versionId === versionId
    && event.familyId === familyId
    && exactSha(event.sha256) === versionSha256.toLowerCase()
  ));
  if (candidateMatches.length > 1) throw new HttpError(409, 'AI product review found conflicting candidate registration events');
  if (!candidateMatches.length) {
    return finishContext({
      evidenceState: 'VERSION_REGISTRY_ONLY',
      missingFields: [
        'candidateRegistration', 'executionRequest', 'run', 'callPackage', 'actualPrompt',
        'recipePrompt', 'parameters', 'inputVersionBindings', 'parentVersionBinding',
      ],
      candidateSnapshotId: null,
      definitionEvidenceState: 'NOT_AVAILABLE',
      executionDefinitionId: typeof version.executionDefinitionRef === 'string' ? version.executionDefinitionRef : null,
      definitionHash: null,
      executionRequestId: null,
      runId: null,
      callPackageHash: null,
      promptRevisionId: null,
      actualPrompt: null,
      actualPromptHash: null,
      recipePrompt: null,
      recipePromptHash: null,
      promptChangedFromCallPackage: null,
      promptSyncRequired: null,
      upload: null,
      model: typeof version.model === 'string' ? { registeredModel: version.model } : null,
      parameters: null,
      output: { projectPath, sha256: file.sha256 },
      source: {
        evidenceClass: 'VERSION_REGISTRY_ONLY',
        sourceRef: typeof version.sourceRef === 'string' ? version.sourceRef : null,
        promptRef: typeof version.promptRef === 'string' ? version.promptRef : null,
      },
      inputVersionBindings: [],
      inputBindingsHash: null,
      parentVersionId: null,
      parentVersionSha256: null,
      parentBindingState: 'UNKNOWN',
      previousRevisionReview: null,
    }, ['production-materials:version-registry-only']);
  }
  const candidate = candidateMatches[0];
  const [runEvents, reviewEvents, executionRequestEvents, recipes] = await Promise.all([
    listAllEvents('run'),
    listAllEvents('review'),
    listAllEvents('execution-request'),
    recipeCatalog(),
  ]);
  const candidateSnapshotId = String(candidate.snapshotId || '');
  if (!candidateSnapshotId) throw new HttpError(409, 'candidate registration has no immutable base snapshot');
  const executionDefinitionId = String(candidate.executionDefinitionId || '');
  const definitionHashAtExecution = exactSha(candidate.executionDefinitionHash);
  const callPackageHash = exactSha(candidate.callPackageHash);
  if (!executionDefinitionId || !definitionHashAtExecution || definitionHashAtExecution !== callPackageHash) {
    throw new HttpError(409, 'candidate execution-definition binding is incomplete or inconsistent');
  }
  const actualPrompt = candidate.actualPrompt;
  const actualPromptHash = exactSha(candidate.actualPromptHash);
  if (!actualPrompt || !actualPromptHash || stableObjectHash(actualPrompt) !== actualPromptHash) {
    throw new HttpError(409, 'candidate actual Prompt is missing or its hash is invalid');
  }
  const recipePromptHash = exactSha(candidate.recipePromptHash);
  if (!recipePromptHash) throw new HttpError(409, 'candidate recipe Prompt hash is missing');
  const promptChangedFromCallPackage = actualPromptHash !== recipePromptHash;
  if (
    candidate.promptChangedFromCallPackage !== promptChangedFromCallPackage
    || candidate.promptSyncRequired !== promptChangedFromCallPackage
  ) {
    throw new HttpError(409, 'candidate Prompt drift flags are inconsistent');
  }
  const inputBindings = Array.isArray(candidate.inputBindings) ? candidate.inputBindings : null;
  const inputBindingsHash = exactSha(candidate.inputBindingsHash);
  if (!inputBindings || !inputBindingsHash || stableObjectHash(inputBindings) !== inputBindingsHash) {
    throw new HttpError(409, 'candidate input bindings are missing or their hash is invalid');
  }
  const executionRequestId = String(candidate.executionRequestId || '');
  const runId = String(candidate.runId || '');
  if (!executionRequestId || !runId) throw new HttpError(409, 'candidate execution lineage is incomplete');
  const executionRequests = executionRequestEvents.filter((event) => event.executionRequestId === executionRequestId);
  if (!executionRequests.length) throw new HttpError(409, 'candidate execution request is missing');
  const immutableRequestBindingMatches = executionRequests.every((event) => (
    String(event.snapshotId || '') === candidateSnapshotId
    && event.familyId === familyId
    && event.executionDefinitionId === executionDefinitionId
    && exactSha(event.executionDefinitionHash) === definitionHashAtExecution
    && exactSha(event.callPackageHash) === callPackageHash
    && exactSha(event.inputBindingsHash) === inputBindingsHash
    && stableObjectHash(Array.isArray(event.inputBindings) ? event.inputBindings : null) === inputBindingsHash
    && String(event.promptRevisionId || '') === String(candidate.promptRevisionId || '')
  ));
  if (!immutableRequestBindingMatches) {
    throw new HttpError(409, 'candidate execution request contradicts its immutable production binding');
  }
  const matchingRuns = runEvents.filter((event) => event.runId === runId);
  if (!matchingRuns.length) throw new HttpError(409, 'candidate run is missing');
  const immutableRunBindingMatches = matchingRuns.every((event) => (
    String(event.snapshotId || '') === candidateSnapshotId
    && event.executionRequestId === executionRequestId
    && event.executionDefinitionId === executionDefinitionId
    && exactSha(event.executionDefinitionHash) === definitionHashAtExecution
    && exactSha(event.callPackageHash) === callPackageHash
    && exactSha(event.inputBindingsHash) === inputBindingsHash
    && String(event.promptRevisionId || '') === String(candidate.promptRevisionId || '')
  ));
  if (!immutableRunBindingMatches) {
    throw new HttpError(409, 'candidate run history contradicts its immutable production binding');
  }
  const run = matchingRuns[0];
  if (!run || eventState(run) !== 'SUCCEEDED') throw new HttpError(409, 'candidate run is missing or is no longer SUCCEEDED');
  if (String(candidate.path || '') !== projectPath || exactSha(candidate.sha256) !== file.sha256) {
    throw new HttpError(409, 'candidate output binding no longer matches the registered version');
  }

  let exactDefinition: Row | null = null;
  if (recipes.snapshotId === data.snapshotId) {
    const currentDefinition = (recipes.executionDefinitions as unknown as Row[]).find((item) => item.id === executionDefinitionId) || null;
    if (currentDefinition) {
      const calculatedDefinitionHash = inspectExecutionDefinitionHash(currentDefinition).calculatedHash;
      const declaredDefinitionHash = exactSha(currentDefinition.definitionHash || calculatedDefinitionHash);
      if (declaredDefinitionHash === definitionHashAtExecution && calculatedDefinitionHash !== definitionHashAtExecution) {
        throw new HttpError(409, 'current production definition claims the candidate hash but its content contradicts that hash');
      }
      if (calculatedDefinitionHash === definitionHashAtExecution) exactDefinition = currentDefinition;
    }
  }
  if (exactDefinition) {
    const exactOutput = exactDefinition.output && typeof exactDefinition.output === 'object' && !Array.isArray(exactDefinition.output)
      ? exactDefinition.output as Record<string, unknown>
      : {};
    if (
      String(exactDefinition.materialRequirementRef || '') !== requirementId
      || (String(exactDefinition.materialRequirementHash || '') !== String(requirement.requirementHash || '')
        && !hasMaterialRequirementCompatibility(data, requirementId, String(exactDefinition.materialRequirementHash || ''), String(requirement.requirementHash || '')))
      || String(exactOutput.assetFamilyRef || '') !== familyId
    ) {
      throw new HttpError(409, 'hash-matched production definition contradicts the current material binding');
    }
    if (stableObjectHash(exactDefinition.prompt || null) !== recipePromptHash) {
      throw new HttpError(409, 'hash-matched production definition contradicts the candidate recipe Prompt hash');
    }
  }
  const parentVersionId = typeof candidate.parentVersionId === 'string' && candidate.parentVersionId ? candidate.parentVersionId : null;
  const parentVersionSha256 = parentVersionId ? exactSha(candidate.parentVersionSha256) : null;
  if (parentVersionId && !parentVersionSha256) throw new HttpError(409, 'candidate parent-version binding is incomplete');
  if (!parentVersionId && candidate.parentVersionSha256) throw new HttpError(409, 'root candidate must not declare a parent-version SHA-256');
  const parentBindingState = String(candidate.parentBindingState || (parentVersionId ? 'BOUND' : 'EXPLICIT_ROOT'));
  if ((parentVersionId && parentBindingState !== 'BOUND') || (!parentVersionId && parentBindingState === 'BOUND')) {
    throw new HttpError(409, 'candidate parent-version binding state is inconsistent');
  }
  const previousRevisionEvent = parentVersionId && parentVersionSha256
    ? reviewEvents.find((event) => (
      event.subjectType === 'ASSET'
      && event.familyId === familyId
      && event.versionId === parentVersionId
      && exactSha(event.versionSha256) === parentVersionSha256
      && event.action === 'REQUEST_REVISION'
    )) || null
    : null;
  const previousRevisionReview = previousRevisionEvent ? {
    eventId: String(previousRevisionEvent.eventId || ''),
    recordedAt: String(previousRevisionEvent.recordedAt || ''),
    criterionFindings: previousRevisionEvent.criterionFindings || [],
    revisionInstructions: previousRevisionEvent.revisionInstructions || null,
    note: typeof previousRevisionEvent.note === 'string' ? previousRevisionEvent.note : null,
  } : null;

  const exactRecipePrompt = exactDefinition?.prompt || (actualPromptHash === recipePromptHash ? actualPrompt : null);
  const missingFields = exactDefinition
    ? []
    : [
      'executionDefinitionContent',
      ...(exactRecipePrompt ? [] : ['recipePrompt']),
      'upload', 'model', 'parameters', 'outputDefinition', 'sourceDefinition',
    ];

  return finishContext({
      evidenceState: 'EXACT_CANDIDATE',
      missingFields,
      candidateSnapshotId,
      definitionEvidenceState: exactDefinition ? 'CURRENT_DEFINITION_EXACT_MATCH' : 'IMMUTABLE_HASH_ONLY',
      executionDefinitionId,
      definitionHash: definitionHashAtExecution,
      executionRequestId,
      runId,
      callPackageHash,
      promptRevisionId: typeof candidate.promptRevisionId === 'string' && candidate.promptRevisionId ? candidate.promptRevisionId : null,
      actualPrompt,
      actualPromptHash,
      recipePrompt: exactRecipePrompt,
      recipePromptHash,
      promptChangedFromCallPackage,
      promptSyncRequired: promptChangedFromCallPackage,
      upload: exactDefinition?.upload || null,
      model: exactDefinition?.model || (typeof version.model === 'string' ? { registeredModel: version.model, evidenceClass: 'VERSION_REGISTRY_ONLY' } : null),
      parameters: exactDefinition?.parametersRaw || null,
      output: exactDefinition?.output || { projectPath, sha256: file.sha256, evidenceClass: 'CANDIDATE_OUTPUT_BINDING' },
      source: exactDefinition?.source || {
        evidenceClass: 'VERSION_REGISTRY_ONLY',
        sourceRef: typeof version.sourceRef === 'string' ? version.sourceRef : null,
        promptRef: typeof version.promptRef === 'string' ? version.promptRef : null,
      },
      inputVersionBindings: inputBindings,
      inputBindingsHash,
      parentVersionId,
      parentVersionSha256,
      parentBindingState,
      previousRevisionReview,
    }, [
      ...(exactDefinition ? [`recipe:${executionDefinitionId}`] : [`call-package-sha256:${callPackageHash}`]),
      `candidate-snapshot:${candidateSnapshotId}`,
      `asset-version-event:${String(candidate.eventId || 'UNKNOWN')}`,
      `execution-request:${executionRequestId}`,
      `run:${runId}`,
      ...(previousRevisionReview ? [`review-event:${previousRevisionReview.eventId}`] : []),
    ]);
}
